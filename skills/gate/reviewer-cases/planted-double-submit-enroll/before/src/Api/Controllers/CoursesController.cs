using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using School.Application.Courses;

namespace School.Api.Controllers;

[ApiController]
[Route("api/courses")]
[Authorize]
public class CoursesController : ControllerBase
{
    private readonly ICourseService _courses;
    private readonly EnrollmentService _enrollments;

    public CoursesController(ICourseService courses, EnrollmentService enrollments)
    {
        _courses = courses;
        _enrollments = enrollments;
    }

    [HttpGet("{id:int}")]
    public async Task<IActionResult> Get(int id, CancellationToken ct)
        => Ok(await _courses.GetAsync(id, User.SchoolId(), ct));
}
