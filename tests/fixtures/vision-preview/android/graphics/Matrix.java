package android.graphics;

// Observable affine boundary. Android post operations left-multiply the matrix.
public class Matrix {
  public static int created;
  public Matrix() { created++; }
  public double a = 1, b, c, d = 1;
  public void setRotate(float degrees) { a = d = 1; b = c = 0; postRotate(degrees); }
  public void setScale(float x, float y) { a = x; b = c = 0; d = y; }
  public boolean postRotate(float degrees) {
    double radians = Math.toRadians(degrees), cos = Math.rint(Math.cos(radians)), sin = Math.rint(Math.sin(radians));
    double na = cos * a - sin * c, nb = cos * b - sin * d;
    c = sin * a + cos * c; d = sin * b + cos * d; a = na; b = nb; return true;
  }
  public boolean postScale(float x, float y) { a *= x; b *= x; c *= y; d *= y; return true; }
  public boolean isIdentity() { return a == 1 && b == 0 && c == 0 && d == 1; }
}
